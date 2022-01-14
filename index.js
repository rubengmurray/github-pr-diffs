
import { Octokit } from 'octokit';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config()
import env from 'env-var';

const AUTH_KEY = env.get('AUTH_KEY').required().asString();
const ORGANIZATION = env.get('ORGANIZATION').required().asString();
const SOURCE_BRANCH = env.get('SOURCE_BRANCH').required().asString();
const REPOSITORIES = env.get('REPOSITORIES').required().asJsonArray();

const CREATE_PRS = true

// Create a personal access token at https://github.com/settings/tokens/new?scopes=repo
// Compare: https://docs.github.com/en/rest/reference/users#get-the-authenticated-user
// https://docs.github.com/en/rest/reference/pulls
const octokit = new Octokit({ auth: AUTH_KEY });

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
 * Loop through the repositories you want to create PRs & generate diffs for
 */
for (const REPOSITORY of REPOSITORIES) {
  // Check for open PRs for this repo
  const pulls = await octokit.request(`GET /repos/{owner}/{repo}/pulls`, {
    owner: ORGANIZATION,
    repo: REPOSITORY,
  });
  
  // Check if one of the PRs is from our environment
  const envPR = await getCreateEnvPR(pulls, REPOSITORY);

  // If there is no PR, check if there is a diff
  if (!envPR) {
    continue
  }

  // console.log(envPR, REPOSITORY)
      
  // Wait for a a bit for rate limiting
  await new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, 250)
  })
  
  // The the pull request details for this environment
  const pull = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
    owner: ORGANIZATION,
    repo: REPOSITORY,
    pull_number: envPR.number.toString()
  });
  
  if (!pull.data) {
    // console.log(envPR, REPOSITORY, 'No pull')
    continue;
  }

  // Wait - rate limiting
  await new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, 250)
  })
  
  // Get all reviews for the PR
  const reviews = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner: ORGANIZATION,
    repo: REPOSITORY,
    pull_number: envPR.number.toString()
  });
  
  // Get all the existing approvals for the PR
  const approvals = reviews.data.filter(o => o.state === 'APPROVED');

  // Get the most recent commit on the PR
  const mostRecentCommit = pull.data[pull.data.length - 1];

  if (!approvals.length) {
    // If there are no approvals then link to the entire PR
    console.log(`https://github.com/${ORGANIZATION}/${REPOSITORY}/pull/${envPR.number}/files`)
  } else {
    // If there are approvals, then link to the diff between the latest approval and the entire PR
    console.log(`https://github.com/${ORGANIZATION}/${REPOSITORY}/pull/${envPR.number}/files/${approvals[approvals.length - 1].commit_id}..${mostRecentCommit.sha}`)
  }
}

