
import { Octokit } from 'octokit';
import axios from 'axios';
import chalk from 'chalk';
import dotenv from 'dotenv';
dotenv.config()
import env from 'env-var';

// Create a personal access token at https://github.com/settings/tokens/new?scopes=repo
const AUTH_KEY = env.get('AUTH_KEY').required().asString();
const ORGANIZATION = env.get('ORGANIZATION').required().asString();
const SOURCE_BRANCH = env.get('SOURCE_BRANCH').required().asString();
const REPOSITORIES = env.get('REPOSITORIES').required().asJsonArray();
const GIT_REVIEWER = env.get('GIT_REVIEWER').required().asString();

// Create PRs if they don't already exist - set to false if looking at others work - avoid PRs being created by the wrong user
const CREATE_PRS = false
const GITHUB_PAGE_LIMIT = 50;

const octokit = new Octokit({ auth: AUTH_KEY });

/**
 * Recursively paginate through the request
 */
export const getRecursively = async (endpoint, envPR, repo, items = [], page = 1) => {
  const res = await octokit.request(endpoint, {
    owner: ORGANIZATION,
    repo,
    pull_number: envPR.number.toString(),
    per_page: GITHUB_PAGE_LIMIT,
    page,
  });

  if (res.data.length === GITHUB_PAGE_LIMIT) {
    return getRecursively(endpoint, envPR, repo, res.data, page + 1);
  }

  return [...items, ...res.data];
}

/**
 * Get an existing PR or create a new one if a diff exists
 */
const getCreateEnvPR = async (pulls, REPOSITORY) => {
  const existingEnvPR = pulls.data.find(p => p.head.label === `${ORGANIZATION}:${SOURCE_BRANCH}`)

  // Return if already exists
  if (existingEnvPR) {
    return existingEnvPR
  }

  try {
    // Check for diff
    const { data } = await axios({
      method: 'get',
      url: `https://api.github.com/repos/${ORGANIZATION}/${REPOSITORY}/compare/master...${SOURCE_BRANCH}`,
      headers: {'Authorization': `Bearer ${AUTH_KEY}`}
    });

    // If no diff, move to the next repo
    if (!data.commits.length) {
      return;
    }

    if (!CREATE_PRS) {
      return;
    }

    // Create the PR
    const newPR = await axios({
      method: 'post',
      url: `https://api.github.com/repos/${ORGANIZATION}/${REPOSITORY}/pulls`,
      headers: {'Authorization': `Bearer ${AUTH_KEY}`, 'Content-Type': 'application/json'},
      data: {
          base: 'master',
          head: SOURCE_BRANCH,
          title: SOURCE_BRANCH,
      },
    });
    console.log(newPR, 'newly created PR')

    return newPR.data;
  } catch (e) {
    // If the PR fails then move to the next repo
    console.error(e);
    return;
  }
}

/**
 * Loop through the repositories you want to process
 * Intentionally using for (const...) for rate limiting
 */
for (const REPOSITORY of REPOSITORIES) {
  // Check for open PRs for this repo
  const pulls = await octokit.request(`GET /repos/{owner}/{repo}/pulls`, {
    owner: ORGANIZATION,
    repo: REPOSITORY,
  });
  
  // Check if one of the PRs is from our environment
  const envPR = await getCreateEnvPR(pulls, REPOSITORY);

  // Defensive... if there is no PR move on to the next repository
  if (!envPR) {
    continue
  }
      
  // Wait - reduce rate limiting risk
  await new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, 200)
  })
  
  // Get all of the commits on the PR
  const pullCommits = await getRecursively("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", envPR, REPOSITORY)
  
  // Defensive... move on if none
  if (!pullCommits.length) {
    continue;
  }

  // Wait - reduce rate limiting risk
  await new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, 200)
  })
  
  // Get all reviews for the PR
  const reviews = await getRecursively("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", envPR, REPOSITORY)
  
  // Get all the existing approvals for the PR
  const approvals = reviews.filter(o => o.state === 'APPROVED');
  const myReviews = reviews.filter(o => o.user.login === GIT_REVIEWER);

  // Get the most recent commit on the PR
  const mostRecentCommit = pullCommits[ pullCommits.length - 1 ];

  // Base repo url
  const repo = `https://github.com/${ORGANIZATION}/${REPOSITORY}`;

  // TODO: Tidy this up a bit
  // General approval status
  if (!approvals.length) {
    // If there are no approvals then link to the entire PR
    console.log(chalk.red(`${REPOSITORY}: No approvals: ${repo}/pull/${envPR.number}/files`))
  } else {
    // Latest commit has been approved
    if (approvals.length && approvals[ approvals.length - 1 ].commit_id === mostRecentCommit.sha) {
      console.log(chalk.green(`${REPOSITORY}: Approval upto date`))
    } else {
      // Link to diff between latest approval and latest commit
      console.log(chalk.yellow(`${REPOSITORY}: Commits since latest approval: ${repo}/pull/${envPR.number}/files/${approvals[approvals.length - 1].commit_id}..${mostRecentCommit.sha}`))
    }
  }

  // Personal review status
  if (myReviews.length) {
    const mostRecentReviewByMe = myReviews[ myReviews.length - 1 ].commit_id;
    if (mostRecentCommit.sha !== mostRecentReviewByMe) {
      console.log(chalk.blue(`${REPOSITORY}: Commits since my last review: ${repo}/pull/${envPR.number}/files/${mostRecentReviewByMe}..${mostRecentCommit.sha}`))
    } else {
      console.log(chalk.gray(`${REPOSITORY}: No commits since my last review`))
    }
  } else {
    console.log(chalk.magenta(`${REPOSITORY}: No reviews by me: ${repo}/pull/${envPR.number}/files/${mostRecentReviewByMe}..${mostRecentCommit.sha}`))
  }
  console.log(`\n`)
}
