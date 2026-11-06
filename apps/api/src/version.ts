/** The release the image was built from, such as `0.3.1` or `main-1a2b3c4`; `dev` for a build from the working tree. */
export function versionOf(env: NodeJS.ProcessEnv): string {
  return env.APP_VERSION || "dev";
}
