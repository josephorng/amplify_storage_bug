import { defineStorage } from "@aws-amplify/backend";

export const storage = defineStorage({
  name: "debug",
  access: (allow) => ({
    "public/*": [
      allow.guest.to(["read", "write", "delete"]),
    ],
  }),
});
