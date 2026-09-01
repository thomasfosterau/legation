/** The dashboard opens on Products; every screen has its own URL. */
import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = () => {
  redirect(307, "/products");
};
