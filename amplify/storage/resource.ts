import { defineStorage } from "@aws-amplify/backend";

export const storage = defineStorage({
  name: "debug",
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
  }),
});
