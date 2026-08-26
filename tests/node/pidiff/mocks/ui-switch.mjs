import { createElement } from "react";

export function Switch(props) {
  const { checked, onCheckedChange, ...rest } = props;
  return createElement("input", { type: "checkbox", defaultChecked: Boolean(checked), readOnly: true, ...rest });
}
