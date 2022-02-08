
import { Octokit } from 'octokit';
import axios from 'axios';
import chalk from 'chalk';
import dotenv from 'dotenv';
dotenv.config()
import env from 'env-var';

const AUTH_KEY = env.get('AUTH_KEY').required().asString();
const ORGANIZATION = env.get('ORGANIZATION').required().asString();
const SOURCE_BRANCH = env.get('SOURCE_BRANCH').required().asString();
const REPOSITORIES = env.get('REPOSITORIES').required().asJsonArray();
const GIT_REVIEWER = env.get('GIT_REVIEWER').required().asString();

// TODO: Make error resistant repositories aren't found on a certain source_branch
const CREATE_PRS = false

// Create a personal access token at https://github.com/settings/tokens/new?scopes=repo
// Compare: https://docs.github.com/en/rest/reference/users#get-the-authenticated-user
// https://docs.github.com/en/rest/reference/pulls
const octokit = new Octokit({ auth: AUTH_KEY });

// TODO: Dry the recursion logic
const getReviews = async (envPR, repo, reviews = [], page = 1) => {
  const limit = 50;
  const newReviews = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner: ORGANIZATION,
    repo,
    pull_number: envPR.number.toString(),
    per_page: limit,
    page,
  });

  if (newReviews.data.length === limit) {
    return getReviews(envPR, repo, newReviews.data, page + 1);
  }

  return [...reviews, ...newReviews.data];
}

const getCommits = async (envPR, repo, pulls = [], page = 1) => {
  const limit = 50;
  const pull = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
    owner: ORGANIZATION,
    repo,
    pull_number: envPR.number.toString(),
    per_page: limit,
    page,
  });

  if (pull.data.length === limit) {
    return getCommits(envPR, repo, pull.data, page + 1);
  }

  return [...pulls, ...pull.data];
}

/**
 * Get an existing PR or create a new one if a diff exists
 * @param {*} pulls 
 * @param {*} REPOSITORY 
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

console.log(`processing...`)

/**
 * Loop through the repositories you want to create PRs & generate diffs for review
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
      
  // Wait for a a bit for rate limiting
  await new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, 250)
  })
  
  // The the pull request details for this environment
  const pullCommits = await getCommits(envPR, REPOSITORY)
  
  // Defensive... move on if not found
  if (!pullCommits.length) {
    continue;
  }

  // Wait - rate limiting
  await new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, 250)
  })
  
  // Get all reviews for the PR
  const reviews = await getReviews(envPR, REPOSITORY)
  
  // Get all the existing approvals for the PR
  const approvals = reviews.filter(o => o.state === 'APPROVED');
  const myReviews = reviews.filter(o => o.user.login === GIT_REVIEWER);

  // Get the most recent commit on the PR
  const mostRecentCommit = pullCommits[ pullCommits.length - 1 ];

  // Base repo url
  const repo = `https://github.com/${ORGANIZATION}/${REPOSITORY}`;

  // TODO: Don't show this if the commits are equal
  if (myReviews.length) {
    const mostRecentReviewByMe = myReviews[myReviews.length - 1].commit_id;
    console.log(chalk.blue(`${REPOSITORY}: Commits since my last review: ${repo}/pull/${envPR.number}/files/${mostRecentReviewByMe}..${mostRecentCommit.sha}`))
  }

  if (!approvals.length) {
    // If there are no approvals then link to the entire PR
    console.log(chalk.red(`${REPOSITORY}: No approvals: ${repo}/pull/${envPR.number}/files`))
  } else {
    if (approvals[approvals.length - 1].commit_id === mostRecentCommit.sha) {
      console.log(chalk.green(`${REPOSITORY}: Approval upto date`))
    } else {
      // If there are approvals, then link to the diff between the latest approval and the entire PR
      console.log(chalk.yellow(`${REPOSITORY}: Approvals since latest: ${repo}/pull/${envPR.number}/files/${approvals[approvals.length - 1].commit_id}..${mostRecentCommit.sha}`))
    }
  }

  console.log(`\n`)
}
