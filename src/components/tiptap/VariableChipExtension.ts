import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Tiptap extension that decorates {{variableName}} patterns as inline chips.
 * Does not modify the document — purely visual via ProseMirror decorations.
 */
export const VariableChipDecoration = Extension.create({
  name: "variableChipDecoration",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("variableChipDecoration"),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const { doc } = state;

            doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;

              const pattern = /\{\{([^}]+)\}\}/g;
              let match: RegExpExecArray | null;

              while ((match = pattern.exec(node.text)) !== null) {
                const from = pos + match.index;
                const to = from + match[0].length;

                decorations.push(
                  Decoration.inline(from, to, {
                    class: "variable-chip",
                  }),
                );
              }
            });

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },
});
