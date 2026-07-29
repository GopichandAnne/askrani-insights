import type { VerticalModule } from "./vertical";
import { RestaurantModule } from "./restaurant";

/**
 * Vertical module registry. Restaurant is implemented; the others are declared
 * so the pipeline resolves a module for any workspace vertical. Grocery is next
 * (guide roadmap Phase 1/2); the expansion verticals (7.4) slot in here.
 */
const MODULES: Record<string, VerticalModule> = {
  restaurant: new RestaurantModule(),
};

export function moduleFor(vertical: string): VerticalModule {
  return MODULES[vertical] ?? MODULES.restaurant;
}

export function hasModule(vertical: string): boolean {
  return vertical in MODULES;
}
