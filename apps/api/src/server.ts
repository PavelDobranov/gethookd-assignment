import { createApp } from "./app.js";

const app = createApp();

app.listen(3000, "0.0.0.0", () => {
  console.log("API listening on port 3000");
});
