import ReactMarkdown from "react-markdown";

export function MarkdownRenderer(props: { body: string; streaming?: boolean }) {
  return <ReactMarkdown>{`${props.body}${props.streaming ? "▍" : ""}`}</ReactMarkdown>;
}
