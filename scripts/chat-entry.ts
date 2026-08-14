// Bundle entry for chat-harness.js. The three host classes have to come out of one
// bundle so they share a single copy of the `vscode` stub: built separately, each
// would get its own, and the stub the test drives would not be the one they use.
export { ChatController } from "../src/chat/chatViewProvider";
export { SessionStore } from "../src/session/sessionStore";
export { ChangeTracker } from "../src/diff/changeTracker";
