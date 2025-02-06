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
  const cacheKey = `github_${endpoint}${options.params ? '_' + JSON.stringify(options.params) : ''}`;
  let cachedData = null;  // Declare at the top of the function
  
  try {
    // Add GitHub API headers
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      ...options.headers
    };

    // Check cache and add If-Modified-Since if available
    cachedData = await getCachedData(cacheKey);  // Assign to the variable in scope
    if (cachedData?.lastModified) {
      headers['If-Modified-Since'] = cachedData.lastModified;
    }

    // Build URL with query parameters
    let url = `https://api.github.com/${endpoint}`;
    if (options.params) {
      const params = new URLSearchParams(options.params);
      url += `?${params.toString()}`;
    }

    console.log('Fetching:', url);
    const response = await fetch(url, {
      ...options,
      headers
    });
    
    // Handle 304 Not Modified
    if (response.status === 304 && cachedData) {
      console.log('Using cached data for:', cacheKey);
      return { data: cachedData.data, fromCache: true };
    }

    if (!response.ok) {
      throw new Error(`GitHub API Error: ${response.status}`);
    }

    const data = await response.json();
    const lastModified = response.headers.get('last-modified');
    
    // Always cache the response
    await setCachedData(cacheKey, data, lastModified);
    console.log('Cached new data for:', cacheKey);

    // Return pagination info in headers
    const linkHeader = response.headers.get('link');
    const hasNextPage = linkHeader?.includes('rel="next"');
    
    return { 
      data, 
      fromCache: false,
      pagination: {
        hasNextPage,
        totalCount: response.headers.get('x-total-count')
      }
    };
  } catch (error) {
    console.error('GitHub API Error:', error);
    if (cachedData) {  // Now cachedData is in scope
      console.log('Using fallback cached data for:', cacheKey);
      return { data: cachedData.data, fromCache: true, isFailover: true };
    }
    throw error;
  }
}

async function getCachedData(key) {
  try {
    const result = await chrome.storage.local.get(key);
    if (!result[key]) {
      console.log('No cache found for:', key);
      return null;
    }

    const cached = result[key];
    if (Date.now() - cached.timestamp > CACHE_DURATION) {
      console.log('Cache expired for:', key);
      return null;
    }
    
    console.log('Found valid cache for:', key);
    return cached;
  } catch (error) {
    console.error('Error reading cache:', error);
    return null;
  }
}

async function setCachedData(key, data, lastModified) {
  try {
    const cacheObject = {
      timestamp: Date.now(),
      lastModified: lastModified || null, //Q. user_data는 http_response에 lastModified가 와서 저장할 수 있는데, repos는 http_response에 lastModified가 안와서 null로 저장되는 문제가 있다. 
                                          //Q. if last_modified_date is null, 1일 단위로 all fetch하는게 어떻게 동작하는거야?
      data: data
    };
    
    await chrome.storage.local.set({ [key]: cacheObject });
    console.log('Successfully cached data for:', key);
    
    // Verify the save
    const saved = await chrome.storage.local.get(key);
    if (!saved[key]) {
      console.error('Failed to verify cache save for:', key);
    }
  } catch (error) {
    console.error('Error setting cache:', error);
  }
}