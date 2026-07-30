I want to make a website that is effectively a small terminal emulator/shell as an interface for my resume.

As an MVP, the emulator/shell should support the following commands:

- help: Shows what commands are available
- experience: Lists my experience in a nicely formatted way
- summary: Lists my summary in a nicely formatted way
- hobbies: Lists my hobbies in a nicely formatted way
- education: Lists my education in a nicely formatted way
- ask "Question?":
    - most challenging part: I want to use the smallest LLM I could reasonably load into memory via WASM to respond to questions about me/my resume. I don't really care if the experience is poor or the model hallucinates, but I know for sure it should be possible to serve a WASM binary that is loaded upon invocation of this command that contains a model that can answer basic questions, even if it's really slow on the user's machine.
    - should also support ask -i or ask --interactive, which launches an interactive session with the aforementioned tiny LLM


I want the terminal emulator to have the Nord color scheme, and look/feel like an actual terminal emulator. For unsupported commands, just return whatever a shell would typically return if the command were not found in PATH.

The LLM/WASM side will be in C, but for the rest of the frontend we can just use whatever you're most comfortable with.
