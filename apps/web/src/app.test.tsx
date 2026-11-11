import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import App from "./app";

afterEach(cleanup);

it("renders the developer portal heading", () => {
  render(<App />);

  expect(
    screen.getByRole("heading", {
      name: "GetHookd Developer Portal",
      level: 1,
    }),
  ).toBeDefined();
});

it("renders a fresh portal without leaking DOM from another test", () => {
  expect(screen.queryByRole("heading")).toBeNull();

  render(<App />);

  expect(screen.getAllByRole("heading")).toHaveLength(1);
});
