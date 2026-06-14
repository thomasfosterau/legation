// EffectSync (Kotlin) — a Kotlin-native client port of the effect-sync engine's
// "Web" implementation (packages/core client modules + packages/browser).
//
// Pure Kotlin/JVM: the engine depends only on the standard library, Kotlin
// coroutines, and kotlinx.serialization, so the rebase/journal/overlay logic is
// testable on any JVM (see ADR-0013). The durable store plugs into a
// `KeyValueStore` seam, so platform databases (Room/DataStore on Android,
// SQLDelight on Kotlin Multiplatform) back it without touching the engine.

plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
}

group = "au.thomasfoster"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    // `api`: `Flow` and `JsonElement` appear in the engine's public surface, so
    // consumers compile against them transitively.
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
}
