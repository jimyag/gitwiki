import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store";

export function Preview({ body }: { body: string }) {
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);

  return (
    <article className="prose-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt, ...rest }) => {
            // Resolve relative asset paths to the API endpoint.
            let resolvedSrc = src ?? "";
            if (resolvedSrc.startsWith("assets/") && currentRepo && pageId) {
              resolvedSrc = `/api/repos/${currentRepo}/asset?page_id=${encodeURIComponent(pageId)}&name=${encodeURIComponent(resolvedSrc.slice("assets/".length))}`;
            }
            return (
              <img
                src={resolvedSrc}
                alt={alt ?? ""}
                {...rest}
                className="max-w-full rounded border border-stone-200 shadow-sm my-4"
                loading="lazy"
              />
            );
          },
          a: ({ href, children, ...rest }) => (
            <a
              href={href}
              target={href?.startsWith("http") ? "_blank" : undefined}
              rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
              className="text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-900"
              {...rest}
            >{children}</a>
          ),
          h1: ({ children }) => <h1 className="text-3xl font-bold text-stone-900 mt-8 mb-4 pb-2 border-b border-stone-100">{children}</h1>,
          h2: ({ children }) => <h2 className="text-2xl font-bold text-stone-900 mt-7 mb-3 pb-1.5 border-b border-stone-100">{children}</h2>,
          h3: ({ children }) => <h3 className="text-xl font-semibold text-stone-900 mt-6 mb-2.5">{children}</h3>,
          h4: ({ children }) => <h4 className="text-base font-semibold text-stone-900 mt-5 mb-2">{children}</h4>,
          p: ({ children }) => <p className="my-3 leading-[1.75] text-stone-700">{children}</p>,
          ul: ({ children }) => <ul className="my-3 pl-6 space-y-1 list-disc marker:text-stone-400">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 pl-6 space-y-1 list-decimal marker:text-stone-500">{children}</ol>,
          li: ({ children }) => <li className="text-stone-700 leading-[1.7]">{children}</li>,
          code: ({ className, children, ...rest }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  className="bg-stone-100 text-emerald-800 rounded px-1 py-0.5 text-[13px] font-mono"
                  {...rest}
                >{children}</code>
              );
            }
            return <code className={className} {...rest}>{children}</code>;
          },
          pre: ({ children }) => (
            <pre className="bg-stone-950 text-stone-100 rounded-lg p-4 overflow-x-auto my-4 text-[13px] leading-[1.6] [&_code]:bg-transparent [&_code]:text-inherit [&_code]:p-0">{children}</pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-stone-300 pl-4 py-0.5 my-4 text-stone-600 italic">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-4">
              <table className="min-w-full text-sm divide-y divide-stone-200 border border-stone-200 rounded">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-stone-50 text-left">{children}</thead>,
          th: ({ children }) => <th className="px-3 py-2 font-semibold text-stone-700 text-xs uppercase tracking-wider">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 text-stone-700 border-t border-stone-100">{children}</td>,
          hr: () => <hr className="my-8 border-t border-stone-200" />,
          strong: ({ children }) => <strong className="font-semibold text-stone-900">{children}</strong>,
          em: ({ children }) => <em className="italic text-stone-700">{children}</em>,
        }}
      >
        {body}
      </ReactMarkdown>
    </article>
  );
}
