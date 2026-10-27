import { mountUI } from "./ui";
import "./styles.css";

window.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("app");
  if (root) void mountUI(root);
});
