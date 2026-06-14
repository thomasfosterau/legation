import SwiftUI

@main
struct EffectSyncTodoApp: App {
    @State private var engine = DemoSync.makeEngine()

    var body: some Scene {
        WindowGroup {
            ContentView(engine: engine)
        }
    }
}
