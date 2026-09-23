import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Children } from "react";
export default async function Page() {
  const text = await readFile(
    join(process.cwd(), "../../docs/whitepaper.md"),
    "utf8",
  );
  return (
    <div className="page rules">
      <span className="eyebrow">THE RULEBOOK / PUBLIC & VERIFIABLE</span>
      <article>
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            h2: ({ children }) => {
              const id = Children.toArray(children)
                .filter(
                  (child) =>
                    typeof child === "string" || typeof child === "number",
                )
                .join("")
                .toLowerCase()
                .replace(/[^\w\s-]/g, "")
                .trim()
                .replace(/\s+/g, "-");
              return <h2 id={id}>{children}</h2>;
            },
          }}
        >
          {text}
        </Markdown>
      </article>
    </div>
  );
}
