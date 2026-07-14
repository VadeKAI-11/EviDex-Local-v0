import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

interface RichTextBlockProps {
  text?: string;
  className?: string;
  style?: CSSProperties;
}

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), "u"],
};

export default function RichTextBlock({ text, className, style }: RichTextBlockProps) {
  if (!text || !text.trim()) {
    return null;
  }

  return (
    <div className={`rich-text-block ${className || ""}`.trim()} style={style}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}