export class CommonResponse<T> {
  constructor(
    public message: string,
    public statusCode: number,
    public data: T,
  ) {}
}
