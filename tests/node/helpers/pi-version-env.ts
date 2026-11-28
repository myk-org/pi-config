import { after, before } from "node:test";
import {
  MIN_PI_VERSION,
  resetPiVersionCache,
  setPiVersionResolverForTests,
} from "../../../extensions/shared/pi-version.js";

/**
 * Simulate a supported Pi host version for unit tests that invoke standalone
 * extension default exports directly outside Pi's jiti extension loader.
 */
export function useSupportedPiVersion(version: string = MIN_PI_VERSION): void {
  before(() => {
    setPiVersionResolverForTests(() => version);
  });
  after(() => {
    resetPiVersionCache();
  });
}
