// A runnable Jetpack Compose (Compose for Desktop) example for the EffectSync
// Kotlin engine. Compose for Desktop builds on a plain JDK — no Android SDK
// required — and the composables are identical to an Android app's, so this
// doubles as the Android usage example (only the app shell differs).

plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    kotlin("plugin.compose") version "2.0.21"
    id("org.jetbrains.compose") version "1.7.1"
}

repositories {
    mavenCentral()
    // Compose for Desktop pulls some androidx.* artifacts that are only on
    // Google's Maven repo.
    google()
}

dependencies {
    implementation("au.thomasfoster:effect-sync-kotlin")
    implementation(compose.desktop.currentOs)
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
}

kotlin {
    jvmToolchain(21)
}

compose.desktop {
    application {
        mainClass = "au.thomasfoster.effectsync.example.MainKt"
    }
}
