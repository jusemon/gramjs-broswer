import type { FileLike } from "../../define";
export declare class File {
    private readonly media;
    constructor(media: FileLike);
    get id(): void;
    get name(): any;
    get mimeType(): string | undefined;
    get width(): any;
    get height(): any;
    get duration(): any;
    get title(): any;
    get performer(): any;
    get emoji(): any;
    get stickerSet(): any;
    get size(): number | import("big-integer").BigInteger | undefined;
    _fromAttr(cls: any, field: string): any;
}
