export interface IStorageService {
  /**
   * Upload file ke storage
   * @param path - Path relatif file (misal: tickets/TC-000001/2026-06-12/image.jpg)
   * @param buffer - Buffer file
   * @param contentType - MIME type file
   * @returns Object dengan URL publik dan path file
   */
  uploadFile(
    path: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<{ url: string; path: string }>;

  /**
   * Delete file dari storage
   * @param path - Path relatif atau URL file yang akan dihapus
   */
  deleteFile(path: string): Promise<void>;

  /**
   * Get URL publik untuk file
   * @param path - Path relatif file
   * @returns URL publik yang bisa diakses
   */
  getFileUrl(path: string): Promise<string>;
}
