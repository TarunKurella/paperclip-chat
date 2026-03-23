import ReactMarkdown from "react-markdown";
import { cn } from "../lib/utils.js";

type MarkdownCodeProps = React.ComponentPropsWithoutRef<"code"> & {
  inline?: boolean;
};

export function MarkdownRenderer(props: { body: string; streaming?: boolean }) {
  return (
    <ReactMarkdown
      components={{
        code({ inline, className, children, ...rest }: MarkdownCodeProps) {
          if (inline) {
            return (
              <code
                className={cn("rounded-sm bg-stone-100 px-1 py-0.5 font-mono text-[0.9em] text-stone-800", className)}
                {...rest}
              >
                {children}
              </code>
            );
          }

          return (
            <code
              className={cn("block overflow-x-auto bg-stone-950 p-3 font-mono text-[13px] leading-6 text-stone-100", className)}
              {...rest}
            >
              {children}
            </code>
          );
        },
        pre({ className, children, ...rest }) {
          return (
            <pre
              className={cn("my-3 overflow-x-auto border border-stone-800 bg-stone-950 shadow-[4px_4px_0_0_#0a0a0a]", className)}
              {...rest}
            >
              {children}
            </pre>
          );
        },
        p({ className, children, ...rest }) {
          return (
            <p className={cn("whitespace-pre-wrap", className)} {...rest}>
              {children}
            </p>
          );
        },
        ul({ className, children, ...rest }) {
          return (
            <ul className={cn("my-2 list-disc space-y-1 pl-5", className)} {...rest}>
              {children}
            </ul>
          );
        },
        ol({ className, children, ...rest }) {
          return (
            <ol className={cn("my-2 list-decimal space-y-1 pl-5", className)} {...rest}>
              {children}
            </ol>
          );
        },
      }}
    >
      {`${props.body}${props.streaming ? "▍" : ""}`}
    </ReactMarkdown>
  );
}
