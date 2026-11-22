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
  const libraries: Readonly<Record<string, string>>;
  export default libraries;
}

declare module "*/SKILL.md" {
  const skill: {
    readonly markdown: string;
    readonly description: string;
    readonly instructions: string;
  };
  export default skill;
}
