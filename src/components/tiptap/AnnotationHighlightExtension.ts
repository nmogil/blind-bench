import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface AnnotationRange {
  id?: string;
  from: number;
  to: number;
}

const pluginKey = new PluginKey("annotationHighlight");

/**
 * Tiptap extension that renders inline highlight decorations for annotation ranges.
 * Annotations are external data (from Convex), not part of the document model.
 * Updated via `editor.dispatch(tr.setMeta(pluginKey, annotations))`.
 */
export const AnnotationHighlightExtension = Extension.create({
  name: "annotationHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        state: {
          init() {
            return { annotations: [] as AnnotationRange[] };
          },
          apply(tr, value) {
            const meta = tr.getMeta(pluginKey);
            if (meta) return { annotations: meta as AnnotationRange[] };
            return value;
          },
        },
        props: {
          decorations(state) {
            const { annotations } =
              pluginKey.getState(state) as { annotations: AnnotationRange[] };
            if (!annotations.length) return DecorationSet.empty;

            const decorations: Decoration[] = [];
            for (const ann of annotations) {
              // Clamp to document bounds
              const from = Math.max(0, ann.from);
              const to = Math.min(state.doc.content.size, ann.to);
              if (from >= to) continue;

              decorations.push(
                Decoration.inline(from, to, {
                  class: "annotation-highlight",
                  "data-annotation-id": ann.id ?? "",
                }),
              );
            }

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),

      // Block all content-modifying transactions so the editor is "view-only"
      // but still allows text selection for annotation creation.
      new Plugin({
        key: new PluginKey("blockEditing"),
        filterTransaction(tr) {
          // Allow meta-only transactions (decorations, selection changes)
          if (!tr.docChanged) return true;
          // Block any document mutation
          return false;
        },
      }),
    ];
  },
});

export { pluginKey as annotationPluginKey };
