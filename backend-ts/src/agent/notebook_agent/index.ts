//
// Notebook agent: DeepTutor's notebook toolset and the background writer.
//
// The writer sub-agent uses the same favorites toolset as the main chat
// (``notebooks`` action tool + ``write_note``/``search_notes``). The old
// BlockNote ``nb_*`` page tools served the removed Co-Writer editor.

export { launch_notebook_job } from "./capability.js";
export {
  list_notebook,
  list_favorites,
  save_favorite,
  notebook_tools,
  register_notebook_tools,
  NOTEBOOK_TOOL_NAMES,
  listNotebooksOrRecords,
  readFavoriteRecord,
  writeNote,
} from "./notebook_tools.js";
