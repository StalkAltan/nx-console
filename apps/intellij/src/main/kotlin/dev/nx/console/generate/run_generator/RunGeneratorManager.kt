package dev.nx.console.generate.run_generator

import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.process.KillableColoredProcessHandler
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.execution.ui.RunContentManager
import com.intellij.lang.javascript.modules.ConsoleProgress
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtil
import dev.nx.console.NxIcons
import dev.nx.console.utils.NxGeneralCommandLine
import dev.nx.console.utils.nxBasePath
import java.io.File

val log = logger<RunGeneratorManager>()

class RunGeneratorManager(val project: Project) {

    private var queuedGeneratorDefinition: List<String>? = null
    private var runningProcessHandler: KillableColoredProcessHandler? = null

    fun queueGeneratorToBeRun(
        generator: String,
        flags: List<String>,
    ) {
        var generatorDefinition: List<String>
        if (generator.matches(Regex("^workspace-(schematic|generator):(.+)"))) {
            generatorDefinition =
                listOf(
                    "workspace-generator",
                    generator.replace(Regex("^workspace-(schematic|generator):"), ""),
                    *flags.toTypedArray()
                )
        } else {
            generatorDefinition = listOf("g", generator, *flags.toTypedArray())
        }

        runningProcessHandler.let {
            if (it == null) {
                runGenerator(generatorDefinition)
                return
            }
            if (it.commandLine.isDryRun()) {
                it.killProcess()
            }
            queuedGeneratorDefinition = generatorDefinition
            it.addProcessListener(
                object : ProcessListener {
                    override fun processTerminated(event: ProcessEvent) {
                        queuedGeneratorDefinition?.let { definition -> runGenerator(definition) }
                        queuedGeneratorDefinition = null
                    }
                }
            )
        }
    }

    private fun runGenerator(definition: List<String>) {
        try {
            ApplicationManager.getApplication()
                .invokeLater(
                    {
                        val commandLine = NxGeneralCommandLine(project, definition)

                        val processHandler = KillableColoredProcessHandler(commandLine)
                        val console =
                            TextConsoleBuilderFactory.getInstance()
                                .createBuilder(project)
                                .filters(NxGeneratorMessageFilter(project, project.nxBasePath))
                                .console

                        console.attachToProcess(processHandler)
                        ConsoleProgress.install(console, processHandler)

                        val contentDescriptor =
                            RunContentDescriptor(
                                console,
                                processHandler,
                                console.component,
                                "Nx Generate",
                                NxIcons.Action
                            )

                        val runContentManager = RunContentManager.getInstance(project)
                        runContentManager.showRunContent(
                            DefaultRunExecutor.getRunExecutorInstance(),
                            contentDescriptor
                        )

                        processHandler.startNotify()
                        this.setProcessHandler(processHandler, definition.isDryRun().not())
                    },
                    ModalityState.defaultModalityState()
                )
        } catch (e: Exception) {
            thisLogger().info("Cannot execute command", e)
        }
    }

    private fun setProcessHandler(
        processHandler: KillableColoredProcessHandler,
        refreshFileSystem: Boolean
    ) {
        processHandler.addProcessListener(
            object : ProcessListener {
                override fun processTerminated(event: ProcessEvent) {
                    runningProcessHandler = null
                    if (refreshFileSystem) {
                        VfsUtil.markDirtyAndRefresh(
                            true,
                            true,
                            true,
                            VfsUtil.findFileByIoFile(File(project.nxBasePath), true)
                        )
                    }
                }
            }
        )
        runningProcessHandler = processHandler
    }
}

private fun List<String>.isDryRun(): Boolean {
    return this.contains("--dry-run") || this.contains("--dryRun")
}

private fun String.isDryRun(): Boolean {
    return this.contains("--dry-run") || this.contains("--dryRun")
}
