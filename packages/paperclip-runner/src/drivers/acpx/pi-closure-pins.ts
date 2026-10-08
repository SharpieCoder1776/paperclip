/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * Pi 1.0.0 dependency graphs were independently installed for all three targets.
 * Native platform execution and paid qualification remain separately required.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "e076276c674dfffccbb488883e18571d77d7225d801fabf5c8391773ddbbfc6c",
  "darwin-x64": "eafd44e672dec4966ef6f038620f003e5d492c889d475886cd66be2e9c2bff1d",
  "linux-x64": "f493df174cfecba3c31c524aa486ae37663cd68f8fcc0d9556e3f615c4a40ce9",
});
