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

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
}
