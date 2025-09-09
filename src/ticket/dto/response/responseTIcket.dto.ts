export class ImageDto {
  id: string;

  url: string;
}

export class TicketListResponseDto {
  id: string;

  idStore: string;

  handler: { nama: string | null } | null;

  noTelp: string;

  category: string;

  status: string;

  description: string;

  fromPayment: string | null;

  toPayment: string | null;

  isDirectSelling: boolean;

  billCode: string | null;

  grandTotal: string | null;

  completedBy: { nama: string | null } | null;

  completedAt: Date | null;

  createdAt: Date;

  images: ImageDto[];
}
