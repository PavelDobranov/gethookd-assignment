import express from "express";

const app = express();

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(3000, "0.0.0.0", () => {
  console.log("API listening on port 3000");
});
