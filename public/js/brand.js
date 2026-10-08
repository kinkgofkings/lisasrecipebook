export function applySite(site) {
  if (!site || typeof document === "undefined") return;
  const theme = site.theme || {};
  const map = {
    ink: "--ink",
    muted: "--muted",
    paper: "--paper",
    card: "--card",
    moss: "--moss",
    moss2: "--moss-2",
    clay: "--clay",
    gold: "--gold",
    blush: "--blush",
    line: "--line",
    shadow: "--shadow",
    fontSerif: "--serif",
    fontSans: "--sans"
  };
  const root = document.documentElement;
  for (const [key, name] of Object.entries(map)) {
    if (theme[key]) root.style.setProperty(name, theme[key]);
  }
  const color = document.querySelector('meta[name="theme-color"]');
  if (color && theme.themeColor) color.setAttribute("content", theme.themeColor);
  const description = document.querySelector('meta[name="description"]');
  if (description && site.brand?.description) description.setAttribute("content", site.brand.description);
  const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (apple) apple.setAttribute("content", site.brand?.shortName || site.brand?.name || "Cookbook");
  if (site.brand?.name) document.title = site.brand.name;
}

export function bookName(site) {
  return site?.brand?.name || "Cookbook";
}
