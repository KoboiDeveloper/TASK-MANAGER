export class ImageDto {
  id: string;

  url: string;
}

export class TicketListResponseDto {
  id: string;

  idStore: string;

  handler: { nik: string | null; nama: string | null; noTelp: string | null } | null;

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

  idtv: string | null;

  reason: string | null;

  images: ImageDto[];
}

export type UserTicketSummaryDto = {
  nik: string;
  name: string;
  uncompleted: number;
  totalAll: number;
};
