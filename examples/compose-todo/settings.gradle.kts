pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
        google()
    }
}

rootProject.name = "compose-todo"

// Depend on the sibling Kotlin library by its module coordinates; the included
// build substitutes `au.thomasfoster:effect-sync-kotlin` for the local project.
includeBuild("../../packages/kotlin")
