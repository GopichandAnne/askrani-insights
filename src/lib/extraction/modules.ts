import type { VerticalModule } from "./vertical";
import { RestaurantModule } from "./restaurant";
import { GroceryModule } from "./grocery";
import { SalonModule } from "./salon";
import { DentalModule } from "./dental";

/**
 * Vertical module registry. Restaurant, grocery, salon (beauty / med-spa) and
 * dental are implemented; further expansion verticals (§7.4) slot in here behind
 * the same VerticalModule interface.
 */
const MODULES: Record<string, VerticalModule> = {
  restaurant: new RestaurantModule(),
  grocery: new GroceryModule(),
  salon: new SalonModule(),
  dental: new DentalModule(),
};

export function moduleFor(vertical: string): VerticalModule {
  return MODULES[vertical] ?? MODULES.restaurant;
}

export function hasModule(vertical: string): boolean {
  return vertical in MODULES;
}
