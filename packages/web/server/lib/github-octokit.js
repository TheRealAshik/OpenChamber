import { Octokit } from '@octokit/rest';
import { getGitHubAuth } from './github-auth.js';

export { Octokit };

export function getOctokitOrNull() {
  const auth = getGitHubAuth();
  if (!auth?.accessToken) {
    return null;
  }
  return new Octokit({ auth: auth.accessToken });
}
