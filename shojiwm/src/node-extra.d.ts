declare module "node:child_process" {
  export interface ChildProcessWithoutNullStreams {
    stdout: {
      on(event: "data", listener: (chunk: Uint8Array) => void): void;
    };
    stderr: {
      on(event: "data", listener: (chunk: Uint8Array) => void): void;
    };
    on(event: "close", listener: (code: number | null) => void): void;
    on(event: "error", listener: (error: unknown) => void): void;
    kill(signal?: string): boolean;
  }

  export function spawn(
    command: string,
    args?: readonly string[],
    options?: { stdio?: "pipe" | "ignore" },
  ): ChildProcessWithoutNullStreams;
}

declare module "node:net" {
  export interface Socket {
    end(data?: string | Uint8Array): void;
  }

  export function createConnection(
    path: string,
    connectionListener?: () => void,
  ): Socket;
}
