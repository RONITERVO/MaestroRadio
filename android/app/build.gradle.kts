plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "com.ronit.maestroradio"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.ronit.maestroradio"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.2.0"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    buildTypes { release { isMinifyEnabled = false } }
    testOptions { unitTests.isReturnDefaultValues = true }
}
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}
