import express from "express";
import axios from "axios";
import cors from "cors";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import crypto from "crypto";


dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ==============================
// CRIAR PAGAMENTO PIX
// ==============================
app.post("/criar-pagamento", async (req, res) => {
  try {
    const { produto, valor, cep, envio } = req.body;

    const idempotencyKey = crypto.randomUUID();

const response = await axios.post(
  "https://api.mercadopago.com/v1/payments",
  {
    transaction_amount: Number(valor),
    description: produto,
    payment_method_id: "pix",
    payer: {
      email: "cliente@email.com"
    },
    notification_url: "https://backen-loja.onrender.com/webhook"
  },
  {
    headers: {
      Authorization: `Bearer ${process.env.MP_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey
    }
  }
);


    const pagamento = response.data;

    res.json({
      qr_code: pagamento.point_of_interaction.transaction_data.qr_code,
      qr_code_base64:
        pagamento.point_of_interaction.transaction_data.qr_code_base64
    });
  } catch (error) {
  console.log("ERRO:", error.response?.data || error.message);
  res.status(500).json({
    erro: "Erro ao criar pagamento",
    detalhe: error.response?.data || error.message
  });
    }
});

// ==============================
// WEBHOOK MERCADO PAGO
// ==============================
app.post("/webhook", async (req, res) => {
  // Esse JSON.stringify ajuda a mostrar o objeto inteiro nos logs do Render
  console.log("CHEGOU ALGO NO WEBHOOK:", JSON.stringify(req.body, null, 2));

  try {
    // 1. Verificação de segurança: evita que o app "quebre" se o MP mandar um aviso vazio
    if (!req.body || !req.body.data || !req.body.data.id) {
      console.log("Aviso: Webhook recebido sem ID de pagamento. Ignorando...");
      return res.sendStatus(200);
    }

    const paymentId = req.body.data.id;
    console.log(`Buscando dados do pagamento ID: ${paymentId}...`);

    // 2. Consulta a API do Mercado Pago
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MP_TOKEN}`
        }
      }
    );

    const pagamento = response.data;
    console.log(`Status do Pagamento ${paymentId}: ${pagamento.status}`);

    // 3. Verifica se aprovou e tenta enviar o e-mail
    if (pagamento.status === "approved") {
      console.log("Pagamento aprovado! Iniciando disparo de e-mail...");
      
      await enviarEmail(
        pagamento.description,
        pagamento.transaction_amount
      );
      
      console.log("Função de e-mail executada sem erros!");
    }

    // 4. Sempre devolve 200 pro Mercado Pago parar de insistir
    res.sendStatus(200);
  } catch (error) {
    // Mostra o erro exato que deu, se falhar
    console.error("ERRO NO WEBHOOK:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// ==============================
// ENVIAR EMAIL
// ==============================
async function enviarEmail(produto, valor) {
  try {
    console.log("Conectando ao servidor do Gmail...");
    
    // Configuração explícita (Evita o erro de Timeout no Render)
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465, // Porta segura padrão do Gmail
      secure: true, 
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    console.log("Disparando a mensagem...");
    
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER, // Enviando para você mesmo
      subject: "✅ Novo pedido pago!",
      text: `Oba! Venda aprovada.\n\nProduto: ${produto}\nValor: R$ ${valor}`
    });

    console.log("E-mail enviado com sucesso! ID da mensagem:", info.messageId);
    
  } catch (error) {
    console.error("ERRO GRAVE AO ENVIAR O E-MAIL:", error.message);
    // Repassa o erro para cima para o Webhook saber que falhou
    throw error; 
  }
}

// ==============================
// INICIAR O SERVIDOR (O QUE HAVIA SUMIDO!)
// ==============================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}...`);
});
