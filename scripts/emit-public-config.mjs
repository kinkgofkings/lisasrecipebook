import { writeFileSync } from "node:fs";
import { publicSite, tenantForHost } from "../shared/white-label.js";

const site = publicSite(tenantForHost("localhost"));
const body = `window.APP_CONFIG = ${JSON.stringify({ apiBase: "", site }, null, 2)};
`;
writeFileSync(new URL("../public/config.js", import.meta.url), body);
console.log(`Wrote public config for ${site.brand.name}`);
