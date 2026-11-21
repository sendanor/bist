declare module "*.html" {
  const text: string;
  export default text;
}

declare module "*.css" {
  const text: string;
  export default text;
}

declare module "cookbook:browser" {
  const text: string;
  export default text;
}

declare module "cookbook:typescript-libraries" {
  const libraries: Readonly<Record<string, string | undefined>>;
  export default libraries;
}
