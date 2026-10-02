package org.vetta.android.ui

import android.app.Activity
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File

/** Save evidence while this test's Activity still exists; never change focus or swallow its failure. */
fun captureDeviceTestFailure(activity: Activity, testName: String, failure: Throwable) {
    runCatching { captureOwnedActivity(activity, testName, failure) }
        .onFailure { Log.e("DeviceTestEvidence", "Could not initialize failure capture", it) }
}

private fun captureOwnedActivity(activity: Activity, testName: String, failure: Throwable) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    // UTP copies this device directory to connected_android_test_additional_output
    // before uninstalling the test APK. Private filesDir would disappear at uninstall.
    val outputRoot =
        InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")
            ?.takeIf { it.isNotBlank() }?.let { File(it) } ?: activity.filesDir
    val directory = File(outputRoot, "device-test-failures/${testName.replace(Regex("[^A-Za-z0-9._-]"), "_")}")
    runCatching {
        check(directory.mkdirs() || directory.isDirectory)
        File(directory, "failure.txt").writeText(failure.stackTraceToString())
        instrumentation.runOnMainSync {
            val window = activity.window
            val decor = window.decorView
            File(directory, "owned-window.txt").writeText(
                """
                activity=${activity.javaClass.name}
                package=${activity.packageName}
                finishing=${activity.isFinishing}
                destroyed=${activity.isDestroyed}
                windowFocus=${activity.hasWindowFocus()}
                decorFocus=${decor.hasFocus()}
                decorWindowFocus=${decor.hasWindowFocus()}
                decorVisibility=${decor.visibility}
                decorLayoutRequested=${decor.isLayoutRequested}
                focusedView=${activity.currentFocus?.javaClass?.name}
                windowType=${window.attributes.type}
                windowFlags=${window.attributes.flags}
                softInputMode=${window.attributes.softInputMode}
                """.trimIndent(),
            )
        }
    }.onFailure { Log.e("DeviceTestEvidence", "Could not record owned window state", it) }

    for (service in listOf("window", "activity", "input_method")) {
        runCatching {
            ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("dumpsys $service")).use { input ->
                File(directory, "$service.txt").outputStream().use { output -> input.copyTo(output) }
            }
        }.onFailure { Log.e("DeviceTestEvidence", "Could not capture $service", it) }
    }
    runCatching {
        val screenshot = instrumentation.uiAutomation.takeScreenshot()
        if (screenshot != null) {
            try {
                File(directory, "screen.png").outputStream().use { output ->
                    check(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output))
                }
            } finally {
                screenshot.recycle()
            }
        } else Log.w("DeviceTestEvidence", "Screenshot was unavailable")
    }.onFailure { Log.e("DeviceTestEvidence", "Could not capture screenshot", it) }
}
