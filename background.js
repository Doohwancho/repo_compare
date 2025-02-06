const CACHE_DURATION = 24 * 60 * 60 * 1000;

// Keep service worker alive
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed');
});

// Ensure service worker is ready
let isServiceWorkerReady = false;

chrome.runtime.onStartup.addListener(() => {
  isServiceWorkerReady = true;
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isServiceWorkerReady) {
    isServiceWorkerReady = true;
  }

  if (request.type === 'fetchGitHubData') {
    // Wrap in async function to handle promises properly
    (async () => {
      try {
        const response = await handleGitHubRequest(request.endpoint, request.options);
        sendResponse(response);
      } catch (error) {
        console.error('Handler error:', error);
        sendResponse({ error: error.message });
      }
    })();
    return true;  // Will respond asynchronously
  }
});

async function handleGitHubRequest(endpoint, options = {}) {
  // Declare variables at the top
  let cachedData = null;
  const username = endpoint.split('/')[1];
  const isRepoRequest = endpoint.includes('/repos');
  const cacheKey = isRepoRequest ? `github_repos_${username}` : `github_${endpoint.replace(/\//g, '_')}`;

  try {
    console.log('Processing request for:', cacheKey);
    
    // Get cached data first
    cachedData = await getCachedData(cacheKey);
    console.log('Cache status:', cachedData ? 'found' : 'not found');

    if (isRepoRequest) {
      return await handleRepoRequest(username, cacheKey, cachedData);
    } else {
      return await handleUserRequest(endpoint, cacheKey, cachedData);
    }
  } catch (error) {
    console.error('Request error:', error);
    // Now cachedData is always defined in this scope
    if (cachedData?.data) {
      return { data: cachedData.data, fromCache: true, isFailover: true };
    }
    throw error;
  }
}

async function handleRepoRequest(username, cacheKey, cachedData) {
  // If we have valid cached data, use it
  if (cachedData?.data && Date.now() - cachedData.timestamp < CACHE_DURATION) {
    console.log('Using valid cached repo data for:', username);
    return { data: cachedData.data, fromCache: true };
  }

  // Make HEAD request
  const headResponse = await fetch(`https://api.github.com/users/${username}/repos`, {
    method: 'HEAD',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      ...(cachedData?.lastModified ? { 'If-Modified-Since': cachedData.lastModified } : {})
    }
  });

  if (headResponse.status === 304 && cachedData?.data) {
    console.log('No updates available, using cached data');
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
      throw new Error(`GitHub API Error: ${response.status}`);
    }

    const repos = await response.json();
    if (repos.length === 0) break;
    
    allRepos = allRepos.concat(repos);
    if (repos.length < 100) break;
    
    page++;
    if (page > 1) await new Promise(resolve => setTimeout(resolve, 1000));
  }

  await setCachedData(cacheKey, allRepos, lastModified);
  console.log(`Cached ${allRepos.length} repos for ${username}`);
  
  return { data: allRepos, fromCache: false };
}

async function handleUserRequest(endpoint, cacheKey, cachedData) {
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

async function getCachedData(key) {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  } catch (error) {
    console.error('Cache read error:', error);
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
    console.log(`Cache set for: ${key}`);
  } catch (error) {
    console.error('Cache write error:', error);
  }
}

// Keep service worker alive
setInterval(() => {
  console.log('Service worker heartbeat');
}, 20000);
