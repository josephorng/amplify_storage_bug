import { defineStorage } from "@aws-amplify/backend";
import { newsScraper } from "../news/news-scraper/resource";
import { newsShortsCreator } from "../news/news-shorts-creator/resource";

export const storage = defineStorage({
  name: "languageAI",
  access: (allow) => ({
    "public/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(["ADMINS"]).to(["read", "write", "delete"]),
    ],
    "input/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(["ADMINS"]).to(["read", "write", "delete"]),
    ],
    "private/snapshot/{entity_id}/*": [
      allow.entity("identity").to(["read", "write", "delete"]),
      allow.groups(["ADMINS"]).to(["read", "write", "delete"]),
    ],
    "news/*": [
      allow.authenticated.to(["read", "write"]),
      allow.groups(["ADMINS"]).to(["read", "write", "delete"]),
      allow.resource(newsScraper).to(["write"]),
      allow.resource(newsShortsCreator).to(["read", "write"]),
    ],
  }),
});
