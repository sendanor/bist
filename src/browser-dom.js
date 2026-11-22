/**
 * Create a DOM element, apply properties, and append its children.
 * @param tag The HTML element name to create.
 * @param props The attributes and event listeners to apply.
 * @param children The ordered DOM nodes or text to append.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") {
      node.className = value;
    } else if (key.startsWith("on")) {
      node.addEventListener(key.slice(2), value);
    } else if (value !== undefined) {
      node.setAttribute(key, value);
    }
  }
  node.append(...children.filter((child) => child != null && child !== false));
  return node;
}

/**
 * Make a button that invokes a supplied click handler.
 * @param text The visible label on the button.
 * @param fn The click listener to register.
 * @param style The optional visual style class.
 */
export function btn(text, fn, style = "") {
  return el("button", { type: "button", className: style, onclick: fn }, text);
}
