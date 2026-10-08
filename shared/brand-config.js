export const services = {
  mealDbApi: "https://www.themealdb.com/api/json/v1/1",
  mealDbMeal: "https://www.themealdb.com/meal/",
  mealDbHost: "themealdb.com",
  wikimediaApi: "https://commons.wikimedia.org/w/api.php",
  pagesProject: "lisas-recipe-book",
  userAgent: "Cookbook/1.0 (white-label family cookbook)"
};

const fullMenu = ["book", "library", "messages", "notes", "studio", "family", "search", "write"];

const lisaTheme = {
  ink: "#3d2433",
  muted: "#7d5a6a",
  paper: "#fff4f8",
  card: "#fffdfd",
  moss: "#d81b60",
  moss2: "#f06292",
  clay: "#ad1457",
  gold: "#f48fb1",
  blush: "#fce4ec",
  line: "rgba(173, 20, 87, 0.16)",
  shadow: "0 18px 50px rgba(173, 20, 87, 0.1)",
  themeColor: "#d81b60",
  fontSerif: '"Fraunces", Georgia, serif',
  fontSans: '"Outfit", "Segoe UI", sans-serif'
};

export const whiteLabel = {
  defaultTenant: "lisa",
  services,
  tenants: {
    lisa: {
      id: "lisa",
      setup: "admins",
      adminEmails: [],
      hosts: ["lisa.synthetix-labz.cloud", "lisas-recipe-book.pages.dev", "localhost", "127.0.0.1"],
      brand: {
        name: "Lisa's Recipe Book",
        shortName: "Lisa's Book",
        owner: "Lisa Miller",
        eyebrow: "For Lisa Miller",
        description: "Cajun and Texas recipes kept for Lisa Miller, with room for her own notes, pictures, and films.",
        heroEyebrow: "Cajun, Texas, and the open library",
        heroTitle: "A table with your name on it.",
        heroBody: "Your plates from the bayou and the Hill Country, dressed in survivor pink, with a whole library when you want something new.",
        installReady: "Install Lisa's book",
        installAdd: "Add Lisa's book",
        installIos: "Tap the Share button, then Add to Home Screen. The pink ribbon will sit with your apps, and the kitchen timer can keep its place.",
        installReadyBody: "Put the book on your home screen. It opens like an app, dressed in pink and gold, and the timer keeps counting when the phone is locked.",
        installHelp: "Open the browser menu and choose Install app or Add to Home Screen. Look for the pink ribbon.",
        imageCredit: "Photograph for Lisa's Recipe Book",
        audience: "Lisa"
      },
      theme: lisaTheme,
      domain: {
        canonical: "https://lisa.synthetix-labz.cloud/",
        customDomain: "lisa.synthetix-labz.cloud",
        subdomain: "lisa"
      },
      payments: {
        enabled: true,
        portals: {
          square: { enabled: true, label: "Square", environment: "sandbox" },
          cashapp: { enabled: true, label: "Cash App", cashtag: "" }
        }
      },
      locations: {
        defaultRegion: "home",
        regions: [
          {
            id: "gulf",
            label: "Gulf Coast",
            box: { south: 25.5, north: 31, west: -97.8, east: -88 },
            cuisines: ["cajun", "texas", "texmex"],
            services: fullMenu,
            note: "Gulf kitchens lead with Cajun and Texas plates."
          },
          {
            id: "texas",
            label: "Texas",
            box: { south: 25.8, north: 36.5, west: -106.7, east: -93.5 },
            cuisines: ["texas", "texmex"],
            services: fullMenu,
            note: "Texas kitchens lead with Hill Country and Tex-Mex plates."
          },
          {
            id: "southwest",
            label: "Southwest",
            box: { south: 31, north: 37.2, west: -115, east: -106.7 },
            cuisines: ["texmex", "texas", "garden"],
            services: fullMenu,
            note: "Southwest kitchens lead with Tex-Mex and garden plates."
          },
          {
            id: "trail",
            label: "Mountain trail",
            box: { south: 37, north: 49, west: -125, east: -106.7 },
            cuisines: ["garden", "gym"],
            services: ["book", "library", "notes", "search", "write"],
            note: "Trail kitchens keep the book and the notepad close."
          },
          {
            id: "heartland",
            label: "Heartland",
            box: { south: 36.5, north: 49, west: -104, east: -84 },
            cuisines: ["texas", "garden", "kids"],
            services: fullMenu,
            note: "Heartland kitchens lead with garden plates and family food."
          },
          {
            id: "northeast",
            label: "Northeast",
            box: { south: 38.5, north: 47.6, west: -80, east: -66 },
            cuisines: ["garden", "library", "kids"],
            services: fullMenu,
            note: "Northeast kitchens lead with garden plates and the open library."
          },
          {
            id: "home",
            label: "Home kitchen",
            cuisines: [],
            services: fullMenu,
            note: ""
          }
        ]
      }
    },
    demo: {
      id: "demo",
      setup: "members",
      adminEmails: [],
      hosts: ["demo.lisas-recipe-book.pages.dev"],
      brand: {
        name: "Demo Cookbook",
        shortName: "Demo Book",
        owner: "the cook",
        eyebrow: "A white-label kitchen",
        description: "A sample cookbook you can rename, recolor, and hang on your own hostname.",
        heroEyebrow: "Your kitchen, your name",
        heroTitle: "Start a book of your own.",
        heroBody: "This copy is a blank kitchen. Rename it, choose colors, and point a hostname at it.",
        installReady: "Install this book",
        installAdd: "Add this book",
        installIos: "Tap the Share button, then Add to Home Screen.",
        installReadyBody: "Put the book on your home screen. It opens like an app.",
        installHelp: "Open the browser menu and choose Install app or Add to Home Screen.",
        imageCredit: "Photograph for this cookbook",
        audience: "the cook"
      },
      theme: {
        ink: "#1f2a24",
        muted: "#5d6b62",
        paper: "#f4f7f2",
        card: "#ffffff",
        moss: "#2f6f4e",
        moss2: "#6fa37a",
        clay: "#1e4d36",
        gold: "#d4a017",
        blush: "#e7f2ea",
        line: "rgba(30, 77, 54, 0.16)",
        shadow: "0 18px 50px rgba(30, 77, 54, 0.1)",
        themeColor: "#2f6f4e",
        fontSerif: '"Fraunces", Georgia, serif',
        fontSans: '"Outfit", "Segoe UI", sans-serif'
      },
      domain: {
        canonical: "https://demo.lisas-recipe-book.pages.dev/",
        customDomain: "demo.lisas-recipe-book.pages.dev",
        subdomain: "demo"
      },
      payments: {
        enabled: true,
        portals: {
          square: { enabled: false, label: "Square", environment: "sandbox" },
          cashapp: { enabled: true, label: "Cash App", cashtag: "" }
        }
      },
      locations: {
        defaultRegion: "home",
        regions: [
          {
            id: "home",
            label: "Home kitchen",
            cuisines: [],
            services: fullMenu,
            note: ""
          }
        ]
      }
    }
  }
};
