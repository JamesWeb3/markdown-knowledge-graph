import { describe, expect, it } from "vitest";
import { buildGraph, splitFrontmatter, wikilinks } from "./buildGraph";

describe("wikilinks", () => {
  it("reads plain, aliased, heading and folder links", () => {
    const body = "See [[Alpha]], [[Beta|the beta note]], [[Gamma#Setup]], [[Delta#Part|alias]] and [[Folder/Epsilon]].";
    expect(wikilinks(body)).toEqual(["Alpha", "Beta", "Gamma", "Delta", "Folder/Epsilon"]);
  });

  it("ignores empty and heading-only links", () => {
    expect(wikilinks("[[ ]] and [[#Only a heading]]")).toEqual([]);
  });
});

describe("splitFrontmatter", () => {
  it("reads the title and returns the body", () => {
    const { title, body } = splitFrontmatter('---\ntitle: "Hello"\ntags: [a]\n---\n# Heading\nText');
    expect(title).toBe("Hello");
    expect(body).toBe("# Heading\nText");
  });
});

describe("buildGraph", () => {
  const files = [
    { path: "Roles/Manager.md", content: "# Operations manager\nOwns [[Onboarding]] and [[Payroll|pay runs]]." },
    { path: "Processes/Onboarding.md", content: "Run by [[Manager]]. Uses [[Systems/HR system#Login]]." },
    { path: "Processes/Payroll.md", content: "---\ntitle: Fortnightly payroll\n---\nBack to [[Manager]] and [[Payroll]] itself." },
    { path: "Systems/HR system.md", content: "No links. [[Does not exist]]" },
    { path: "Readme.md", content: "Top-level note, links [[onboarding]] in lower case.\n```\n[[Manager]] in code is ignored\n```" },
    { path: "image.png", content: "" },
  ];
  const g = buildGraph(files);

  it("makes one node per markdown file, grouped by top folder", () => {
    expect(g.nodes.map((n) => n.id).sort()).toEqual([
      "Processes/Onboarding",
      "Processes/Payroll",
      "Readme",
      "Roles/Manager",
      "Systems/HR system",
    ]);
    expect(g.groups).toEqual(["Processes", "Roles", "Root", "Systems"]);
  });

  it("takes the label from frontmatter, then the first heading, then the file name", () => {
    const label = (id: string) => g.nodes.find((n) => n.id === id)!.label;
    expect(label("Processes/Payroll")).toBe("Fortnightly payroll");
    expect(label("Roles/Manager")).toBe("Operations manager");
    expect(label("Systems/HR system")).toBe("HR system");
  });

  it("de-duplicates mutual links, drops self-links and counts unresolved ones", () => {
    const pairs = g.links.map((l) => [l.source, l.target].sort().join(" | ")).sort();
    expect(pairs).toEqual([
      "Processes/Onboarding | Readme",
      "Processes/Onboarding | Roles/Manager",
      "Processes/Onboarding | Systems/HR system",
      "Processes/Payroll | Roles/Manager",
    ]);
    expect(g.unresolved).toBe(1);
  });

  it("sizes nodes by link count", () => {
    const onboarding = g.nodes.find((n) => n.id === "Processes/Onboarding")!;
    const hr = g.nodes.find((n) => n.id === "Systems/HR system")!;
    expect(onboarding.degree).toBe(3);
    expect(hr.degree).toBe(1);
    expect(onboarding.weight).toBeGreaterThan(hr.weight);
  });
});
