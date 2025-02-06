const CACHE_DURATION = 24 * 60 * 60 * 1000;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'fetchGitHubData') {
    handleGitHubRequest(request.endpoint, request.options)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

async function handleGitHubRequest(endpoint, options = {}) {
  const username = endpoint.split('/')[1];
  const isRepoRequest = endpoint.includes('/repos');
  const cacheKey = isRepoRequest ? `github_repos_${username}` : `github_${endpoint.replace(/\//g, '_')}`;
  
  try {
    const cachedData = await getCachedData(cacheKey);
    
    // For repository requests, handle pagination and caching differently
    if (isRepoRequest) {
      // If we have valid cached data, use it
      if (cachedData?.data && Date.now() - cachedData.timestamp < CACHE_DURATION) {
        console.log('Using valid cached repo data for:', username);
        return { data: cachedData.data, fromCache: true };
      }

      // Make HEAD request to check for updates
      const headResponse = await fetch(`https://api.github.com/users/${username}/repos`, {
        method: 'HEAD',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          ...(cachedData?.lastModified ? { 'If-Modified-Since': cachedData.lastModified } : {})
        }
      });

      // If nothing has changed, use cached data
      if (headResponse.status === 304 && cachedData?.data) {
        console.log('No updates available, using cached repo data for:', username);
        return { data: cachedData.data, fromCache: true };
      }

      // Fetch all pages
      let allRepos = [];
      let page = 1;
      const lastModified = headResponse.headers.get('last-modified');

      while (true) {
        console.log(`Fetching page ${page} for ${username}`);
        const response = await fetch(
          `https://api.github.com/users/${username}/repos?sort=created&direction=desc&per_page=100&page=${page}`,
          { headers: { 'Accept': 'application/vnd.github.v3+json' } }
        );

        if (!response.ok) {
          if (response.status === 403) throw new Error('Rate limit exceeded. Please try again later.');
          throw new Error(`Failed to fetch repositories for ${username}`);
        }

        const repos = await response.json();
        if (repos.length === 0) break;
        
        allRepos = allRepos.concat(repos);
        
        if (repos.length < 100) break;
        page++;
        
        // Add delay between requests
        if (page > 1) await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Cache all repos together
      await setCachedData(cacheKey, allRepos, lastModified);
      console.log(`Cached ${allRepos.length} repos for ${username}`);
      
      return { data: allRepos, fromCache: false };
    } else {
      // Handle non-repository requests (e.g., user data)
      const headers = {
        'Accept': 'application/vnd.github.v3+json',
        ...(cachedData?.lastModified ? { 'If-Modified-Since': cachedData.lastModified } : {})
      };

      const response = await fetch(`https://api.github.com/${endpoint}`, { headers });
      
      if (response.status === 304 && cachedData) {
        return { data: cachedData.data, fromCache: true };
      }

      if (!response.ok) {
        throw new Error(`GitHub API Error: ${response.status}`);
      }

      const data = await response.json();
      const lastModified = response.headers.get('last-modified');
      
      await setCachedData(cacheKey, data, lastModified);
      return { data, fromCache: false };
    }
  } catch (error) {
    console.error('GitHub API Error:', error);
    if (cachedData?.data) {
      return { data: cachedData.data, fromCache: true, isFailover: true };
    }
    throw error;
  }
}

async function getCachedData(key) {
  try {
    const result = await chrome.storage.local.get(key);
    if (!result[key]) return null;
    return result[key];
  } catch (error) {
    console.error('Error reading cache:', error);
    return null;
  }
}

async function setCachedData(key, data, lastModified) {
  try {
    const cacheObject = {
      timestamp: Date.now(),
      lastModified: lastModified || null,
      data: data
    };
    await chrome.storage.local.set({ [key]: cacheObject });
    console.log(`Successfully cached data for: ${key}`);
  } catch (error) {
    console.error('Error setting cache:', error);
  }
}
