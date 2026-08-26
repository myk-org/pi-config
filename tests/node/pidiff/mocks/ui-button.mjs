import { createElement } from "react";

export function Button({ children, ...props }) {
  return createElement("button", props, children);
}

export const buttonVariants = () => "";
