// A stand-in for the SDK, to see what describeSdkApi makes of it.
export const sdkVersion = "1.0.0";

/** A comment that the API text leaves out. */
export type Identity = {
  id: string;
  version?: string;
};

export function isIdentity(value: unknown): value is Identity {
  return typeof value === "object" && value !== null && "id" in value;
}

function internal(): number {
  return 1;
}
export const answer = internal();
