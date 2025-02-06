// Constants
const FIXED_USERS = ['Doohwancho', 'utilforever'];
const CACHE_DURATION = 24 * 60 * 60 * 1000;
const currentYear = new Date().getFullYear();

// Inject comparison UI into GitHub page
function injectComparisonUI() {
  // Look for mt-4 class div specifically inside user-profile-frame (그래야 로그아웃 페이지에서도 올바른 위치에 insert된다.)
  const userProfileFrame = document.getElementById('user-profile-frame');
  if (!userProfileFrame) {
      console.log('User profile frame not found');
      return;
  }

  const targetElement = userProfileFrame.querySelector('.mt-4');
  if (!targetElement) {
      console.log('Target element not found inside user profile frame');
      return;
  }

  const currentUsername = window.location.pathname.split('/')[1];
  if (!FIXED_USERS.includes(currentUsername)) {
      console.log('Not a target user page');
      return;
  }

  const comparisonHTML = `
      <div class="gh-comparison-wrapper">
          <div class="gh-comparison-content">
              <div class="gh-user-column" id="user1-repos">
                  <div class="gh-user-header" id="user1-header"></div>
              </div>
              <div class="gh-user-column" id="user2-repos">
                  <div class="gh-user-header" id="user2-header"></div>
              </div>
          </div>
      </div>
  `;

  // Insert before the target element
  targetElement.insertAdjacentHTML('beforebegin', comparisonHTML);

  initComparison();
}


// Cache management functions
async function getCachedData(key) {
    try {
        const result = await chrome.storage.local.get(key);
        if (!result[key]) return null;

        const cached = result[key];
        if (Date.now() - cached.timestamp > CACHE_DURATION) {
            return null;
        }
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
            lastModified: lastModified || null,
            data: data
        };
        await chrome.storage.local.set({ [key]: cacheObject });
    } catch (error) {
        console.error('Error setting cache:', error);
    }
}

async function sendToBackground(type, data) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...data }, response => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }
  
  // Modified API functions to use background script
  async function fetchUserData(username) {
    try {
      const response = await sendToBackground('fetchGitHubData', {
        endpoint: `users/${username}`
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching user data:', error);
      throw error;
    }
  }
  
  async function fetchAllRepos(username) {
    try {
      let allRepos = [];
      let page = 1;
      let hasNextPage = true;
  
      while (hasNextPage) {
        console.log(`Fetching page ${page} for ${username}`);
        const response = await sendToBackground('fetchGitHubData', {
          endpoint: `users/${username}/repos`,
          options: {
            headers: {
              'Accept': 'application/vnd.github.v3+json'
            },
            params: {
              sort: 'created',
              direction: 'desc',
              per_page: 100,
              page: page
            }
          }
        });
  
        if (!response.data || response.error) {
          throw new Error(response.error || 'Failed to fetch repos');
        }
  
        allRepos = allRepos.concat(response.data);
        console.log(`Fetched ${response.data.length} repos for ${username}`);
  
        // Check if we have more pages
        hasNextPage = response.pagination?.hasNextPage && response.data.length === 100;
        page++;
  
        // Add delay between requests to avoid rate limits
        if (hasNextPage) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
  
      console.log(`Total repos fetched for ${username}: ${allRepos.length}`);
      return allRepos;
    } catch (error) {
      console.error('Error fetching repos:', error);
      throw error;
    }
  }

function createYearSection(year, yearRepos, isCurrentYear = false) {
    const section = document.createElement('div');
    section.className = 'gh-year-section';
    
    const header = document.createElement('div');
    header.className = 'gh-year-header';
    header.innerHTML = `
        <strong>${year}</strong> (${yearRepos.length} repositories)
        <div class="gh-collapse-icon ${isCurrentYear ? '' : 'collapsed'}">▼</div>
    `;

    const content = document.createElement('div');
    content.className = `gh-year-content ${isCurrentYear ? '' : 'collapsed'}`;

    yearRepos.forEach(repo => {
        const repoCard = document.createElement('div');
        repoCard.className = 'gh-repo-card';
        repoCard.innerHTML = `
            <a href="${repo.html_url}" class="gh-repo-name">${repo.name}</a>
            <div class="gh-repo-description">${repo.description || 'No description available'}</div>
            <div class="gh-repo-meta">
                ${repo.language ? `<span>🔸 ${repo.language}</span> • ` : ''}
                ⭐ ${repo.stargazers_count} • 🍴 ${repo.forks_count}
            </div>
        `;
        content.appendChild(repoCard);
    });

    section.appendChild(header);
    section.appendChild(content);

    header.addEventListener('click', () => {
        content.classList.toggle('collapsed');
        header.querySelector('.gh-collapse-icon').classList.toggle('collapsed');
    });

    return section;
}

function groupReposByYear(repos) {
    return repos.reduce((acc, repo) => {
        const year = new Date(repo.created_at).getFullYear();
        if (!acc[year]) acc[year] = [];
        acc[year].push(repo);
        return acc;
    }, {});
}


async function createUserColumn(userData, repos, columnId) {
  const column = document.getElementById(columnId);
  const headerElement = column.querySelector('.gh-user-header');
  
  // Set up user header
  headerElement.innerHTML = `
      <img src="${userData.avatar_url}" alt="${userData.login}" class="gh-user-avatar">
      <div class="gh-user-info">
          <h2>${userData.login}</h2>
          <div>Public repos: ${userData.public_repos}</div>
      </div>
  `;

  const reposByYear = groupReposByYear(repos);
  
  Object.entries(reposByYear)
      .sort(([a], [b]) => b - a)
      .forEach(([year, yearRepos]) => {
          const yearSection = createYearSection(
              parseInt(year),
              yearRepos,
              parseInt(year) === currentYear
          );
          column.appendChild(yearSection);
      });
}

async function initComparison() {
    try {
        // Fetch data for both users simultaneously
        const [user1Data, user2Data] = await Promise.all([
            fetchUserData(FIXED_USERS[0]),
            fetchUserData(FIXED_USERS[1])
        ]);

        const [user1Repos, user2Repos] = await Promise.all([
            fetchAllRepos(FIXED_USERS[0]),
            fetchAllRepos(FIXED_USERS[1])
        ]);

        // console.log(user1Repos);
        // console.log(user2Repos);

        // Create columns for both users
        await Promise.all([
            createUserColumn(user1Data, user1Repos, 'user1-repos'),
            createUserColumn(user2Data, user2Repos, 'user2-repos')
        ]);
    } catch (error) {
        console.error('Error initializing comparison:', error);
    }
}

// Initialize when the page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectComparisonUI);
} else {
    injectComparisonUI();
}
